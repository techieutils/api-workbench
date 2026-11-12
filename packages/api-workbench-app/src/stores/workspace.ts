import { defineStore } from 'pinia';
import { ref, shallowRef, triggerRef } from 'vue';
import * as http from '@techieutils/api-workbench-common/http-settings';
import type {
  ApiRequest,
  AppSettings,
  AuthType,
  WorkspaceChange,
  Environment,
  KeyValue,
  MockServer,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import { requestShape, syncRequestsToMocks } from '@techieutils/api-workbench-common/mock-sync';
import { dynamicValue } from '@techieutils/api-workbench-common/variables';
import { REQUEST_PROTOCOLS } from '@techieutils/api-workbench-common/types';
import {
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import { render } from '../shell';
import { toast, uid } from '../utils';
import { AUTH_TYPE_NAMES, useAuthenticationStore, migratedAuthType } from './authentication';
import { useToolsStore } from './tools';
import { useUiStore } from './ui';
import { useWorkspacesStore } from './workspaces';
import { normalizedLibrary, normalizedScripts } from '@techieutils/api-workbench-common/scripts';
import { normalizedSnippets } from '@techieutils/api-workbench-common/script-snippets';
import { normalizedFolderTags, normalizedTags } from '@techieutils/api-workbench-common/tags';

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceName: 'Personal workspace',
  timeoutMs: 60000,
  followRedirects: true,
  defaultAccept: 'application/json',
  historyEnabled: true,
  historyLimit: 100,
  persistResponses: false,
  theme: 'dark',
  density: 'comfortable',
  editorFontSize: 12,
  wordWrap: false,
  runnerDelayMs: 0,
  stopRunnerOnFailure: false,
  autoSave: 'change',
  autoSaveDelaySeconds: 3,
};
const PROTOCOLS: readonly string[] = REQUEST_PROTOCOLS;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
const BODY_TYPES = ['none', 'raw', 'form-data', 'x-www-form-urlencoded', 'binary'];
/** Option values that are secrets, cleared from backups and shared exports. */
const SECRET_OPTIONS = {
  awsSessionToken: undefined,
  oauth1TokenSecret: undefined,
  oauth2ClientSecret: undefined,
  oauth2RefreshToken: undefined,
  oauth2ExpiresAt: undefined,
};
const SECRET_KEY = /secret|token|password|api[-_]?key|credential/i;
const SECRET_HEADER = /authorization|cookie|token|secret|api[-_]?key/i;

export const makeRequest = (
  name: string,
  method: string,
  url: string,
  folder = 'Getting started',
): ApiRequest => ({
  id: uid(),
  name,
  method,
  url,
  folder,
  params: [],
  headers: [],
  body: '',
  auth: 'None',
  token: '',
  username: '',
  password: '',
  tests: 'status 200\nresponse-time < 3000',
  response: null,
});
/** The sample workspace shown before any is saved. */
function sampleWorkspace(): WorkspaceState {
  const requests = [
    makeRequest('Get all users', 'GET', '{{base_url}}/users'),
    makeRequest('Get a user', 'GET', '{{base_url}}/users/1'),
    makeRequest('Create a user', 'POST', '{{base_url}}/users'),
    makeRequest('Update a user', 'PATCH', '{{base_url}}/users/1'),
    makeRequest('Delete a user', 'DELETE', '{{base_url}}/users/1'),
    makeRequest('Get all posts', 'GET', '{{base_url}}/posts', 'Posts'),
    makeRequest('GraphQL query', 'POST', 'https://graphqlzero.almansi.me/api', 'GraphQL'),
  ];
  const json = { enabled: true, key: 'Content-Type', value: 'application/json' };
  requests[2].body = JSON.stringify({ name: 'Alex Morgan', email: 'alex@example.com' }, null, 2);
  requests[2].headers.push({ ...json });
  requests[6].body = JSON.stringify({ query: '{ user(id: 1) { id name email } }' }, null, 2);
  requests[6].headers.push({ ...json });
  const environment = (name: string): Environment => ({
    name,
    variables: [{ enabled: true, key: 'base_url', value: 'https://jsonplaceholder.typicode.com' }],
  });
  return {
    requests,
    active: requests[0].id,
    tabs: requests.slice(0, 2).map((request) => request.id),
    environments: [environment('Development'), environment('Production')],
    environment: 0,
    history: [],
  };
}
function importedRows(value: unknown): KeyValue[] {
  if (!Array.isArray(value)) throw new Error('Imported parameters and headers must be arrays.');
  return value.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.key !== 'string' ||
      typeof row.value !== 'string'
    )
      throw new Error('Imported rows must have string keys and values.');
    if (row.description !== undefined && typeof row.description !== 'string')
      throw new Error('Row descriptions must be strings.');
    return {
      key: row.key,
      value: row.value,
      enabled: row.enabled !== false,
      description: row.description,
    };
  });
}
interface ImportedCollection {
  requests?: ApiRequest[];
  settings?: Partial<AppSettings>;
  collectionHttpSettings?: WorkspaceState['collectionHttpSettings'];
  collectionAuth?: unknown;
  collectionScripts?: unknown;
  workspaceScripts?: unknown;
  scriptLibrary?: unknown;
  scriptSnippets?: unknown;
  collectionTags?: unknown;
  environments?: Environment[];
}

/**
 * The workspace document. It stays a plain object: it is structured-cloned for saving and sent
 * over IPC, which deep reactive proxies cannot survive. Code mutates it in place and then calls
 * render() or persist(), which trigger `refresh()` so every component reading it re-renders.
 * `revision` covers state that is not reactive at all; see useRendered().
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const state = shallowRef<WorkspaceState>(sampleWorkspace());
  const revision = ref(0);
  /** Live protocol connections change on every streamed event; only their views track this. */
  const liveRevision = ref(0);
  /** Bumped per save, so only the latest save reports its outcome. */
  let persistenceVersion = 0;
  /** Set when the saved workspace could not be loaded, so it is never overwritten. */
  const persistenceBlocked = ref(false);
  /** Changes made since the last save, when auto save waits (a pause) or is off. */
  const unsaved = ref(false);
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function refresh(): void {
    revision.value++;
    triggerRef(state);
  }

  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, ...state.value.settings });
  function normalizedSettings(saved: Partial<AppSettings> = {}): AppSettings {
    const number = (value: unknown, fallback: number, min: number, max: number): number =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
    return {
      ...DEFAULT_SETTINGS,
      workspaceName:
        typeof saved.workspaceName === 'string' && saved.workspaceName.trim()
          ? saved.workspaceName.trim().slice(0, 60)
          : DEFAULT_SETTINGS.workspaceName,
      timeoutMs: number(saved.timeoutMs, 60000, 100, 300000),
      httpSettings: http.overrides(saved.httpSettings),
      historyLimit: number(saved.historyLimit, 100, 0, 1000),
      editorFontSize: number(saved.editorFontSize, 12, 10, 18),
      runnerDelayMs: number(saved.runnerDelayMs, 0, 0, 30000),
      theme: ['dark', 'light', 'system'].includes(saved.theme || '') ? saved.theme! : 'dark',
      density: saved.density === 'compact' ? 'compact' : 'comfortable',
      defaultAccept: ['application/json', '*/*', 'application/xml', 'text/plain'].includes(
        saved.defaultAccept || '',
      )
        ? saved.defaultAccept!
        : 'application/json',
      followRedirects: saved.followRedirects !== false,
      historyEnabled: saved.historyEnabled !== false,
      persistResponses: saved.persistResponses === true,
      wordWrap: saved.wordWrap === true,
      stopRunnerOnFailure: saved.stopRunnerOnFailure === true,
      autoSave: saved.autoSave === 'delay' || saved.autoSave === 'off' ? saved.autoSave : 'change',
      autoSaveDelaySeconds: number(saved.autoSaveDelaySeconds, 3, 1, 60),
    };
  }
  function current(): ApiRequest {
    const request = state.value.requests.find((item) => item.id === state.value.active);
    if (!request) throw new Error('No active request');
    return request;
  }
  /** A data-driven run's current row, which comes before the environment while it is set. */
  let dataRow: Record<string, string> | undefined;
  /** Resolves variables with a data row's values first, for one iteration of a run. */
  function withDataRow<T>(row: Record<string, string> | undefined, callback: () => T): T {
    const previous = dataRow;
    dataRow = row;
    try {
      return callback();
    } finally {
      dataRow = previous;
    }
  }
  // A data row's values come first, then environment variables, so a workspace may override a
  // built-in {{$name}}.
  const resolve = (value: string): string =>
    String(value).replace(
      /\{\{([^}]+)\}\}/g,
      (_, key: string) =>
        (dataRow && Object.hasOwn(dataRow, key.trim()) ? dataRow[key.trim()] : undefined) ??
        state.value.environments[state.value.environment]?.variables.find(
          (variable) => variable.enabled && variable.key === key.trim(),
        )?.value ??
        dynamicValue(key.trim()) ??
        `{{${key}}}`,
    );

  /** The active environment's variables that are switched on and named. */
  const activeVariables = () =>
    state.value.environments[state.value.environment].variables.filter(
      (variable) => variable.enabled && variable.key,
    );

  // Saving
  /** The workspace as saved: responses are kept only when the setting allows it. */
  function persistedWorkspace(): WorkspaceState {
    const snapshot = structuredClone(state.value);
    // History keeps responses (or failures) and each send's console lines for this session; they
    // are written only while responses are saved.
    if (!settings().persistResponses)
      snapshot.history = snapshot.history.map((entry) => {
        const kept = { ...entry };
        delete kept.response;
        delete kept.console;
        delete kept.failure;
        return kept;
      });
    snapshot.requests.forEach((request) => {
      if (!settings().persistResponses) request.response = null;
      // Binary bodies are kept for previews in this session only, not in the workspace file.
      else if (request.response && 'bodyBase64' in request.response)
        delete request.response.bodyBase64;
    });
    return snapshot;
  }
  /** The workspace without secrets, history, or responses, for exports and backups. */
  function backupWorkspace(): WorkspaceState {
    const snapshot = structuredClone(state.value);
    const scrub = (rows: KeyValue[], pattern: RegExp) =>
      rows.map((row) => ({ ...row, value: pattern.test(row.key) ? '' : row.value }));
    snapshot.requests.forEach((request) => {
      request.httpSettings = http.redactProxySettings(request.httpSettings);
      request.token = '';
      request.password = '';
      request.credentialId = undefined;
      if (request.authOptions) request.authOptions = { ...request.authOptions, ...SECRET_OPTIONS };
      request.response = null;
      request.bodyFields = request.bodyFields?.map((field) => ({
        ...field,
        value: SECRET_KEY.test(field.key) ? '' : field.value,
        fileId: undefined,
      }));
      request.headers = scrub(request.headers, SECRET_HEADER);
    });
    snapshot.environments.forEach(
      (environment) => (environment.variables = scrub(environment.variables, SECRET_KEY)),
    );
    if (snapshot.settings)
      snapshot.settings.httpSettings = http.redactProxySettings(snapshot.settings.httpSettings);
    snapshot.collectionHttpSettings = Object.fromEntries(
      Object.entries(snapshot.collectionHttpSettings || {}).map(([name, config]) => [
        name,
        http.redactProxySettings(config),
      ]),
    );
    snapshot.history = [];
    snapshot.collectionAuth = Object.fromEntries(
      Object.entries(snapshot.collectionAuth || {}).map(([folder, config]) => [
        folder,
        {
          ...config,
          token: '',
          password: '',
          credentialId: undefined,
          authOptions: config.authOptions && { ...config.authOptions, ...SECRET_OPTIONS },
        },
      ]),
    );
    snapshot.clientCertificates = snapshot.clientCertificates?.map((certificate) => ({
      ...certificate,
      passphrase: undefined,
    }));
    if (snapshot.cookieJar)
      snapshot.cookieJar = { enabled: snapshot.cookieJar.enabled, cookies: [] };
    return snapshot;
  }
  /**
   * What each request's method, URL, name, and folder were at the last save, to tell new and
   * changed requests apart for the mock servers made from their collections. Started afresh for
   * each workspace opened, so only edits made since bring changes.
   */
  let requestsSeen: { state: WorkspaceState; requests: Map<string, ApiRequest> } | undefined;
  const mockListeners = new Set<(mocks: MockServer[]) => void>();
  /** Hears which mock servers changed with their collections, such as to restart running ones. */
  function onMocksSynced(listener: (mocks: MockServer[]) => void): () => void {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  }
  /** Brings mock servers made from collections in step with the requests added or changed. */
  function syncMocksFromRequests(): void {
    const current = state.value;
    const seen = requestsSeen?.state === current ? requestsSeen.requests : undefined;
    const changed = seen ? syncRequestsToMocks(current.mocks ?? [], current.requests, seen) : [];
    requestsSeen = {
      state: current,
      requests: new Map(current.requests.map((request) => [request.id, requestShape(request)])),
    };
    if (changed.length) for (const listener of mockListeners) listener(changed);
  }
  /**
   * Records a change to the workspace and saves it as auto save says: at once, after a pause in
   * editing, or not until Save. Every edit calls this.
   */
  function persist(): void {
    syncMocksFromRequests();
    const ui = useUiStore();
    if (persistenceBlocked.value) {
      toast(
        'Saving is disabled because the existing workspace could not be loaded. Restart after resolving the file error.',
        'error',
      );
      return;
    }
    useToolsStore().scheduleDockedCodeGeneration();
    const mode = settings().autoSave;
    if (mode === 'change') void write().catch(() => {});
    else {
      markUnsaved(true);
      ui.saveState = mode === 'off' ? 'Unsaved changes' : 'Saving shortly…';
      clearTimeout(autoSaveTimer);
      if (mode === 'delay')
        autoSaveTimer = setTimeout(
          () => void write().catch(() => {}),
          settings().autoSaveDelaySeconds * 1000,
        );
    }
    // Edits that skip render(), such as renaming a request in place, still reach the shell.
    refresh();
  }
  /** Tells the main process, so closing the window saves first or asks (when auto save is off). */
  function markUnsaved(value: boolean): void {
    const changed = unsaved.value !== value;
    unsaved.value = value;
    if (changed || value)
      void window.workbench?.workspaces.setUnsaved?.(value, settings().autoSave === 'off');
  }
  /** Writes the workspace now. Rejects when it cannot be saved, after saying so. */
  function write(): Promise<void> {
    const ui = useUiStore();
    clearTimeout(autoSaveTimer);
    if (persistenceBlocked.value) return Promise.reject(new Error('Saving is disabled.'));
    const version = ++persistenceVersion;
    const id = useWorkspacesStore().manager.id;
    ui.saveState = 'Saving…';
    const wasUnsaved = unsaved.value;
    markUnsaved(false);
    return useWorkspacesStore()
      .saveSnapshot(persistedWorkspace(), id)
      .then(() => {
        // Changes made while this save ran are still waiting; the status keeps saying so.
        if (version === persistenceVersion && !unsaved.value)
          ui.saveState = useWorkspacesStore().isTeam()
            ? 'Saved to the team folder'
            : 'Saved locally';
      })
      .catch((error: unknown) => {
        if (version === persistenceVersion) {
          ui.saveState = 'Save failed';
          if (wasUnsaved || settings().autoSave !== 'change') markUnsaved(true);
          toast('Could not save workspace. Check available disk space.', 'error');
        }
        throw error;
      });
  }
  /** Saves now, whatever auto save says: Save, switching workspaces, Git sync, and closing. */
  function saveNow(): Promise<void> {
    return write();
  }
  /** Drops the outcome of saves started for the previous workspace. */
  function resetPersistence(): void {
    persistenceVersion++;
    clearTimeout(autoSaveTimer);
    markUnsaved(false);
  }
  let unwatchWorkspace: (() => void) | undefined;
  /**
   * Takes the workspace as it now is on disk, after its files changed outside the app. Responses
   * kept in this session stay for requests that still exist; tabs for removed requests close. Disk
   * wins over in-app edits made in the same moment, which have been saving all along.
   */
  function applyWorkspaceChange(change: WorkspaceChange): void {
    if ('error' in change) {
      toast(`Workspace files not reloaded: ${change.error}`, 'warning');
      return;
    }
    const previous = new Map(state.value.requests.map((request) => [request.id, request]));
    const next = useWorkspacesStore().normalize({
      ...change.state,
      requests: change.state.requests.map((request) => ({
        ...request,
        response: previous.get(request.id)?.response ?? request.response ?? null,
      })),
    });
    const ids = new Set(next.requests.map((request) => request.id));
    next.tabs = next.tabs.filter((id) => ids.has(id));
    next.recentTabs = next.recentTabs?.filter((id) => ids.has(id));
    next.closedTabs = next.closedTabs?.filter((id) => ids.has(id));
    if (!next.active || !ids.has(next.active)) next.active = next.tabs[0] ?? next.requests[0].id;
    if (!next.tabs.includes(next.active)) next.tabs.push(next.active);
    const before = state.value;
    state.value = next;
    render();
    void window.workbench?.workspaces.workspaceChangeApplied?.(change.sequence);
    if (!useWorkspacesStore().isTeam()) {
      toast('Reloaded workspace files changed outside the app', 'info');
      return;
    }
    // In a team folder, teammates' sends only add history: that needs no notice. Changed
    // requests are named, so you know what moved under you.
    // Compared without regard to key order or unset fields, which differ between the copy in the
    // app and the one read back from the folder.
    const stable = (value: unknown) =>
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item)
                .filter(([, field]) => field !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : item,
      );
    const definition = (request: ApiRequest) => stable({ ...request, response: null });
    const changed = next.requests.filter(
      (request) =>
        !previous.has(request.id) || definition(previous.get(request.id)!) !== definition(request),
    );
    const removed = before.requests.filter((request) => !ids.has(request.id)).length;
    const shared = (value: WorkspaceState) =>
      stable([
        value.environments,
        value.specs,
        value.mocks,
        value.collectionAuth,
        value.collectionScripts,
        value.workspaceScripts,
        value.scriptLibrary,
        value.scriptSnippets,
        value.collectionTags,
      ]);
    if (!changed.length && !removed && shared(before) === shared(next)) return;
    const names = changed.slice(0, 3).map((request) => `“${request.name}”`);
    toast(
      changed.length
        ? `Teammates updated ${names.join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`
        : removed
          ? `Teammates removed ${removed} ${removed === 1 ? 'request' : 'requests'}`
          : 'Teammates updated environments or collection settings',
      'info',
    );
  }
  /** Loads the active workspace; a failure blocks saving so the files are never overwritten. */
  async function load(): Promise<void> {
    const ui = useUiStore();
    const workspaces = useWorkspacesStore();
    try {
      await workspaces.initialize();
      const id = workspaces.manager.id;
      const saved: WorkspaceState | null = window.workbench
        ? await window.workbench.load(id)
        : JSON.parse(localStorage.getItem(workspaces.storageKey(id)) || 'null');
      if (saved) {
        state.value = workspaces.normalize(saved);
        if (!state.value.tabs.length) ui.view = 'Overview';
      } else state.value.settings = { ...DEFAULT_SETTINGS };
      // Workspace and collection files edited outside the app (an editor, git) reload here.
      unwatchWorkspace?.();
      unwatchWorkspace = window.workbench?.workspaces.onWorkspaceChange?.(applyWorkspaceChange);
    } catch (error) {
      persistenceBlocked.value = true;
      ui.saveState = 'Workspace load failed';
      setTimeout(() => toast(error instanceof Error ? error.message : String(error), 'error'), 0);
    }
  }

  // Importing
  /** Adds an imported collection; nothing is committed unless the whole file is valid. */
  async function importCollection(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object')
      throw new Error('Choose a supported collection or API specification.');
    const authentication = useAuthenticationStore();
    const data = WorkbenchTransfer.convertDocument(raw).data as ImportedCollection;
    const requests: ApiRequest[] = [];
    const environments: Environment[] = [];
    if (!Array.isArray(data.requests)) throw new Error('No requests or environments found.');
    if (!data.requests.length && !data.environments?.length)
      throw new Error('No requests or environments found.');
    for (const item of data.requests) {
      if (
        !item ||
        typeof item.url !== 'string' ||
        typeof item.method !== 'string' ||
        !METHODS.includes(item.method)
      )
        throw new Error('An imported request has an invalid URL or method.');
      const request = makeRequest(
        typeof item.name === 'string' ? item.name : 'Imported request',
        item.method,
        item.url,
        typeof item.folder === 'string' ? item.folder : 'Imported',
      );
      if (item.protocol !== undefined && !PROTOCOLS.includes(item.protocol))
        throw new Error('Invalid request protocol.');
      request.protocol = item.protocol;
      if (item.grpc && typeof item.grpc.proto === 'string' && typeof item.grpc.method === 'string')
        request.grpc = {
          proto: item.grpc.proto,
          method: item.grpc.method,
          tls: item.grpc.tls === true,
        };
      if (item.protocol === 'socketio') request.socketio = normalizedSocketIO(item.socketio);
      if (item.protocol === 'mqtt') request.mqtt = normalizedMQTT(item.mqtt);
      request.httpSettings = http.overrides(item.httpSettings);
      request.params = importedRows(item.params || []);
      request.headers = importedRows(item.headers || []);
      if (item.captures) request.captures = importedRows(item.captures);
      // Imported scripts are kept, and wait to run until their collection is allowed.
      const scripts = normalizedScripts(item.scripts);
      if (scripts) request.scripts = scripts;
      const tags = normalizedTags(item.tags);
      if (tags) request.tags = tags;
      if (item.bodyType && BODY_TYPES.includes(item.bodyType)) request.bodyType = item.bodyType;
      if (typeof item.rawContentType === 'string') request.rawContentType = item.rawContentType;
      if (
        typeof item.editorLanguage === 'string' &&
        WorkbenchEditor.languages.some((language) => language.id === item.editorLanguage)
      )
        request.editorLanguage = item.editorLanguage;
      if (item.bodyFields)
        request.bodyFields = importedRows(item.bodyFields).map((row, index) => ({
          ...row,
          kind: item.bodyFields![index].kind === 'file' ? 'file' : 'text',
          fileName: item.bodyFields![index].fileName,
        }));
      if (typeof item.binaryName === 'string') request.binaryName = item.binaryName;
      for (const field of ['body', 'tests', 'token', 'username', 'password'] as const)
        if (typeof item[field] === 'string') request[field] = item[field];
      item.auth = migratedAuthType(item.auth) as AuthType;
      if (AUTH_TYPE_NAMES.includes(item.auth)) request.auth = item.auth;
      const authOptions = authentication.importedAuthOptions(item.authOptions);
      if (authOptions) request.authOptions = authOptions;
      requests.push(request);
    }
    if (Array.isArray(data.environments))
      for (const environment of data.environments) {
        if (!environment || typeof environment.name !== 'string')
          throw new Error('An imported environment is invalid.');
        environments.push({
          name: environment.name,
          variables: importedRows(environment.variables),
        });
      }
    const importedCollections = http.collectionOverrides(data.collectionHttpSettings);
    const importedCollectionAuth = authentication.importedCollectionAuthConfig(data.collectionAuth);
    const importedSettings = data.settings ? normalizedSettings(data.settings) : undefined;
    // Commit only after the entire file has passed validation.
    const target = state.value;
    target.requests.push(...requests);
    target.environments.push(...environments);
    target.collectionHttpSettings = { ...target.collectionHttpSettings, ...importedCollections };
    target.collectionAuth = { ...target.collectionAuth, ...importedCollectionAuth };
    // Imported collection and folder scripts are kept, and paused until allowed.
    const importedScripts = Object.entries(
      (data.collectionScripts as Record<string, unknown> | undefined) ?? {},
    ).flatMap(([folder, value]) => {
      const scripts = normalizedScripts(value);
      return typeof folder === 'string' && scripts ? [[folder, scripts] as const] : [];
    });
    // A workspace's own scripts come in only where it has none, so an import never replaces them.
    const importedWorkspaceScripts = normalizedScripts(data.workspaceScripts);
    if (importedWorkspaceScripts && !target.workspaceScripts)
      target.workspaceScripts = importedWorkspaceScripts;
    // Library modules come in under names not yet used; a module already here is kept as it is.
    const taken = new Set((target.scriptLibrary ?? []).map((module) => module.name.toLowerCase()));
    const modules = (normalizedLibrary(data.scriptLibrary) ?? []).filter(
      (module) => !taken.has(module.name.toLowerCase()),
    );
    if (modules.length) target.scriptLibrary = [...(target.scriptLibrary ?? []), ...modules];
    // Collection and folder tags come in, over any the same folders had.
    const importedTags = normalizedFolderTags(data.collectionTags);
    if (importedTags) target.collectionTags = { ...target.collectionTags, ...importedTags };
    // Saved snippets come in unless one with the same id is already here.
    const known = new Set((target.scriptSnippets ?? []).map((snippet) => snippet.id));
    const snippets = (normalizedSnippets(data.scriptSnippets) ?? []).filter(
      (snippet) => !known.has(snippet.id),
    );
    if (snippets.length) target.scriptSnippets = [...(target.scriptSnippets ?? []), ...snippets];
    if (importedScripts.length)
      target.collectionScripts = {
        ...target.collectionScripts,
        ...Object.fromEntries(importedScripts),
      };
    if (importedSettings) target.settings = importedSettings;
    persist();
    render();
  }
  return {
    state,
    onMocksSynced,
    revision,
    liveRevision,
    persistenceBlocked,
    refresh,
    settings,
    normalizedSettings,
    current,
    resolve,
    withDataRow,
    activeVariables,
    persistedWorkspace,
    backupWorkspace,
    persist,
    saveNow,
    unsaved,
    resetPersistence,
    load,
    importCollection,
  };
});
