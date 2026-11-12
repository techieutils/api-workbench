import { renameMockCollections } from '@techieutils/api-workbench-common/mock-sync';
import { defineStore } from 'pinia';
import * as payload from '@techieutils/api-workbench-common/request-payload';
import { trimHistory } from '@techieutils/api-workbench-common/history';
import { nextTick, toRaw } from 'vue';
import { payloadSettings } from '@techieutils/api-workbench-common/http-settings';
import type {
  ApiRequest,
  HistoryConsoleEntry,
  HistoryFailure,
  HistoryResponse,
  HttpResponse,
  RequestPayload,
  RequestError,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import {
  collectionOf,
  folderLabel,
  folderName,
  folderNameProblem,
  folderPaths,
  folderTree,
  isWithin,
  joinFolder,
  moveFolderPath,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import { render } from '../shell';
import { errorMessage, toast, uid } from '../utils';
import { useAuthenticationStore } from './authentication';
import { useCookiesStore } from './cookies';
import { useHTTPSettingsStore } from './http-settings';
import { useProtocolsStore, requestProtocol } from './protocols';
import { useRequestBodyStore } from './request-body';
import { useRequestTabsStore } from './request-tabs';
import { useRequestTestsStore } from './request-tests';
import { useResponseStore } from './response';
import { useRunnerStore } from './runner';
import { useSettingsStore } from './settings';
import { useToolsStore } from './tools';
import { useUiStore } from './ui';
import { makeRequest, useWorkspaceStore } from './workspace';
import { confirmAction } from '../confirm';
import { useScreensStore } from './screens';
import { useScriptsStore } from './scripts';
import { scriptHostProblem, type StepResult } from '@techieutils/api-workbench-common/scripts';

/**
 * Saved requests: opening, creating, duplicating, and deleting them, the URL kept in step with
 * the Params table, and sending an HTTP request and recording its response.
 */
/** HTTP settings and default auth saved per collection and folder, keyed by folder path. */
const FOLDER_DEFAULTS = [
  'collectionHttpSettings',
  'collectionAuth',
  'collectionScripts',
  'collectionTags',
] as const;

/** The longest response body History keeps for an entry. */
const HISTORY_BODY_LIMIT = 256 * 1024;
/** A response as History keeps it: text bodies up to the limit, binary bodies left out. */
function historyResponse(response: HttpResponse): HistoryResponse {
  const binary = Boolean(response.bodyBase64);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { ...response.headers },
    body: binary ? '' : response.body.slice(0, HISTORY_BODY_LIMIT),
    ...(binary ? { binary: true } : {}),
    ...(!binary && response.body.length > HISTORY_BODY_LIMIT ? { truncated: true } : {}),
    size: response.size,
    ...(response.setCookies?.length
      ? { setCookies: response.setCookies.map((cookie) => ({ ...cookie })) }
      : {}),
    ...(response.timings ? { timings: structuredClone(response.timings) } : {}),
    ...(response.tls ? { tls: structuredClone(response.tls) } : {}),
  };
}
/** A failed request as History keeps it: the error, and the timing and TLS it got through. */
function historyFailure(result: RequestError): HistoryFailure {
  return {
    error: result.error,
    ...(result.timings ? { timings: structuredClone(result.timings) } : {}),
    ...(result.tls ? { tls: structuredClone(result.tls) } : {}),
  };
}
export const useRequestsStore = defineStore('requests', () => {
  const workspace = useWorkspaceStore();
  const ui = useUiStore();
  /** Cancels a browser fetch; Electron requests are cancelled by id. */
  let abortController: AbortController | undefined;

  /** The URL with the enabled Params rows as its query, replacing the rows it had before. */
  const requestQueryURL = payload.requestQueryURL;
  function syncRequestQuery(request: ApiRequest, previousKeys: string[] = []): void {
    request.url = requestQueryURL(request, previousKeys);
    if (request.id === workspace.state.active) {
      const input = document.querySelector<HTMLInputElement>('#url');
      if (input) input.value = request.url;
    }
  }

  function openRequest(id: string): void {
    const state = workspace.state;
    if (!state.requests.some((request) => request.id === id))
      return toast('This request is no longer in the workspace', 'warning');
    useRequestTabsStore().remember(id);
    useHTTPSettingsStore().scope = 'request';
    state.active = id;
    if (!state.tabs.includes(id)) state.tabs.push(id);
    ui.view = 'Collections';
    workspace.persist();
    render();
  }
  function createRequest(): void {
    const request = makeRequest('Untitled request', 'GET', 'https://');
    workspace.state.requests.push(request);
    openRequest(request.id);
    document.querySelector<HTMLInputElement>('#url')?.focus();
  }
  function duplicateRequest(): void {
    const copy = structuredClone(workspace.current());
    copy.id = uid();
    copy.name += ' (copy)';
    copy.response = null;
    workspace.state.requests.push(copy);
    openRequest(copy.id);
  }
  /** The index of a folder's last request, or -1. */
  const lastIndexIn = (requests: ApiRequest[], folder: string) => {
    for (let index = requests.length - 1; index >= 0; index--)
      if (requests[index].folder === folder) return index;
    return -1;
  };
  /** The index of the last request in a folder or any folder inside it, or -1. */
  const lastIndexWithin = (requests: ApiRequest[], folder: string) => {
    for (let index = requests.length - 1; index >= 0; index--)
      if (isWithin(requests[index].folder, folder)) return index;
    return -1;
  };
  /** The collections in explorer order (first appearance). */
  const collectionNames = () => [
    ...new Set(workspace.state.requests.map((request) => collectionOf(request.folder))),
  ];
  /** Every folder path, collections included, in explorer order. */
  const folderPathList = () => folderPaths(folderTree(workspace.state.requests));
  /** A name not yet taken among `taken`: the base, then "base 2", "base 3", … */
  function freeName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
  const freeCollectionName = (base: string) => freeName(base, new Set(collectionNames()));
  /** The names of the folders directly inside `parent` (collections when it is undefined). */
  const childNames = (parent: string | undefined) =>
    new Set(
      folderPathList()
        .filter((path) => parentFolder(path) === parent)
        .map(folderName),
    );
  /** Adds a blank request to a collection, after its last request, and opens it. */
  function createRequestIn(folder: string): void {
    const request = makeRequest('Untitled request', 'GET', 'https://', folder);
    const requests = workspace.state.requests;
    const last = lastIndexIn(requests, folder);
    requests.splice(last < 0 ? requests.length : last + 1, 0, request);
    openRequest(request.id);
    void nextTick(() => document.querySelector<HTMLInputElement>('#url')?.focus());
  }
  /**
   * Starts a collection. Collections exist through their requests, so it begins with one blank
   * request, and its name is ready to edit.
   */
  function createCollection(): void {
    const folder = freeCollectionName('New collection');
    const request = makeRequest('Untitled request', 'GET', 'https://', folder);
    workspace.state.requests.push(request);
    openRequest(request.id);
    ui.startFolderRename(folder);
  }
  /**
   * Starts a folder inside a collection or another folder. Like a collection, it exists through
   * its requests, so it begins with one blank request, and its name is ready to edit.
   */
  function createFolder(parent: string): void {
    const folder = joinFolder(parent, freeName('New folder', childNames(parent)));
    const request = makeRequest('Untitled request', 'GET', 'https://', folder);
    const requests = workspace.state.requests;
    const last = lastIndexWithin(requests, parent);
    requests.splice(last < 0 ? requests.length : last + 1, 0, request);
    // The new folder shows inside its parent, so open the parent and everything above it.
    for (let path: string | undefined = parent; path !== undefined; path = parentFolder(path))
      ui.collapsedFolders.delete(path);
    openRequest(request.id);
    ui.startFolderRename(folder);
  }
  /** Copies a collection, with its folders, HTTP settings, and default authentication, under a new name. */
  function duplicateCollection(folder: string): void {
    const state = workspace.state;
    const name = freeCollectionName(`${folder} copy`);
    const copies = state.requests
      .filter((request) => isWithin(request.folder, folder))
      .map((request) => ({
        ...structuredClone(toRaw(request)),
        id: uid(),
        folder: moveFolderPath(request.folder, folder, name),
        response: null,
      }));
    if (!copies.length) return;
    const last = lastIndexWithin(state.requests, folder);
    state.requests.splice(last + 1, 0, ...copies);
    for (const key of FOLDER_DEFAULTS) {
      const byFolder = state[key];
      for (const path of Object.keys(byFolder || {}))
        if (isWithin(path, folder))
          byFolder![moveFolderPath(path, folder, name)] = structuredClone(
            toRaw(byFolder![path]),
          ) as never;
    }
    workspace.persist();
    render();
    toast(`Duplicated ${folder} as ${name}`, 'success');
  }
  /**
   * Deletes a collection or a folder after confirmation, with everything inside it: requests and
   * their tabs, and the HTTP settings and default authentication of every level inside.
   */
  async function deleteFolder(folder: string): Promise<void> {
    const state = workspace.state;
    const collection = parentFolder(folder) === undefined;
    const doomed = state.requests.filter((request) => isWithin(request.folder, folder));
    if (!doomed.length) return;
    if (doomed.length === state.requests.length)
      return toast(
        collection
          ? 'Keep at least one collection. Create another before deleting this one.'
          : 'Keep at least one request in the workspace.',
        'warning',
      );
    const requestCount = `${doomed.length} request${doomed.length === 1 ? '' : 's'}`;
    const confirmed = await confirmAction({
      title: collection
        ? `Delete the “${folder}” collection?`
        : `Delete the “${folderName(folder)}” folder?`,
      message: collection
        ? `Its ${requestCount}, folders, collection settings, and default authentication are removed from the workspace.`
        : `Its ${requestCount}, folders, settings, and default authentication are removed from the workspace.`,
      confirmLabel: collection ? 'Delete collection' : 'Delete folder',
      tone: 'danger',
    });
    if (!confirmed) return;
    const protocols = useProtocolsStore();
    const ids = new Set(doomed.map((request) => request.id));
    for (const id of ids) {
      void protocols.stopLiveProtocol(id);
      protocols.live.delete(id);
      protocols.protocolUI.delete(id);
    }
    state.requests = state.requests.filter((request) => !ids.has(request.id));
    state.tabs = state.tabs.filter((tab) => !ids.has(tab));
    state.recentTabs = state.recentTabs?.filter((tab) => !ids.has(tab));
    state.closedTabs = state.closedTabs?.filter((tab) => !ids.has(tab));
    for (const key of FOLDER_DEFAULTS)
      for (const path of Object.keys(state[key] || {}))
        if (isWithin(path, folder)) delete state[key]![path];
    for (const path of [...ui.collapsedFolders])
      if (isWithin(path, folder)) ui.collapsedFolders.delete(path);
    if (!state.active || ids.has(state.active)) {
      state.active = state.tabs[0] ?? state.requests[0].id;
      if (!state.tabs.includes(state.active)) state.tabs.push(state.active);
    }
    workspace.persist();
    render();
    toast(
      collection ? `Deleted the ${folder} collection` : `Deleted the ${folderName(folder)} folder`,
      'success',
    );
  }
  /**
   * Moves a request into a collection, before another request or after the collection's last.
   * Returns false when nothing changed. Offers to undo the move.
   */
  function moveRequest(id: string, folder: string, beforeId?: string): boolean {
    const requests = workspace.state.requests;
    const from = requests.findIndex((request) => request.id === id);
    if (from < 0 || id === beforeId) return false;
    const request = requests[from];
    const previous = { folder: request.folder, index: from };
    requests.splice(from, 1);
    let to = beforeId ? requests.findIndex((item) => item.id === beforeId) : -1;
    if (to < 0) {
      const last = lastIndexIn(requests, folder);
      to = last < 0 ? requests.length : last + 1;
    }
    if (to === from && request.folder === folder) {
      requests.splice(from, 0, request);
      return false;
    }
    request.folder = folder;
    requests.splice(to, 0, request);
    workspace.persist();
    render();
    if (previous.folder !== folder)
      toast(`Moved “${request.name}” to ${folderLabel(folder)}`, {
        tone: 'success',
        action: {
          label: 'Undo',
          run: () => {
            const index = requests.indexOf(request);
            if (index < 0) return;
            requests.splice(index, 1);
            request.folder = previous.folder;
            requests.splice(Math.min(previous.index, requests.length), 0, request);
            workspace.persist();
            render();
          },
        },
      });
    return true;
  }
  /** Moves a request one place up or down within its collection (Alt+Arrow in the explorer). */
  function shiftRequest(id: string, step: -1 | 1): void {
    const requests = workspace.state.requests;
    const request = requests.find((item) => item.id === id);
    if (!request) return;
    const siblings = requests.filter((item) => item.folder === request.folder);
    const position = siblings.indexOf(request);
    const neighbour = siblings[position + step];
    if (!neighbour) return;
    const a = requests.indexOf(request);
    const b = requests.indexOf(neighbour);
    [requests[a], requests[b]] = [requests[b], requests[a]];
    workspace.persist();
    render();
  }
  /**
   * Renames a collection or folder to `to` (a name, not a path), moving every folder inside it.
   * The HTTP settings and default authentication of every level inside move with it, and a
   * collection also takes the screens showing it.
   * Returns why the name was refused, or undefined once renamed (or unchanged).
   */
  function renameFolder(from: string, to: string): string | undefined {
    const name = to.trim();
    if (name === folderName(from)) return undefined;
    const problem = folderNameProblem(name);
    if (problem) return problem;
    const parent = parentFolder(from);
    const collection = parent === undefined;
    if (childNames(parent).has(name))
      return collection
        ? `A collection named “${name}” already exists.`
        : `A folder named “${name}” is already in ${folderName(parent!)}.`;
    const target = collection ? name : joinFolder(parent!, name);
    const state = workspace.state;
    for (const request of state.requests)
      request.folder = moveFolderPath(request.folder, from, target);
    for (const path of [...ui.collapsedFolders])
      if (isWithin(path, from)) {
        ui.collapsedFolders.delete(path);
        ui.collapsedFolders.add(moveFolderPath(path, from, target));
      }
    for (const key of FOLDER_DEFAULTS) {
      const byFolder = state[key];
      for (const path of Object.keys(byFolder || {}))
        if (isWithin(path, from)) {
          byFolder![moveFolderPath(path, from, target)] = byFolder![path] as never;
          delete byFolder![path];
        }
    }
    if (collection) {
      useRunnerStore().renameCollection(from, target);
      // Mocks made from it stay in step with it under its new name.
      renameMockCollections(state.mocks, from, target);
      const documentation = useScreensStore().documentation;
      if (documentation.collection === from) documentation.collection = target;
    }
    workspace.persist();
    render();
    return undefined;
  }
  async function deleteRequest(id: string): Promise<void> {
    const state = workspace.state;
    const request = state.requests.find((item) => item.id === id);
    if (!request) return;
    if (state.requests.length < 2) {
      toast('Keep at least one request in the workspace.', 'warning');
      return;
    }
    const confirmed = await confirmAction({
      title: `Delete “${request.name}”?`,
      message: 'The request and its saved tests are removed from the workspace.',
      confirmLabel: 'Delete request',
      tone: 'danger',
    });
    if (!confirmed || !state.requests.includes(request)) return;
    const protocols = useProtocolsStore();
    void protocols.stopLiveProtocol(id);
    protocols.live.delete(id);
    protocols.protocolUI.delete(id);
    const index = state.requests.findIndex((item) => item.id === id);
    state.requests = state.requests.filter((item) => item.id !== id);
    state.tabs = state.tabs.filter((tab) => tab !== id);
    state.recentTabs = state.recentTabs?.filter((tab) => tab !== id);
    state.closedTabs = state.closedTabs?.filter((tab) => tab !== id);
    if (ui.renamingRequestId === id) ui.renamingRequestId = undefined;
    if (state.active === id) {
      state.active = state.requests[Math.min(index, state.requests.length - 1)].id;
      if (!state.tabs.includes(state.active)) state.tabs.push(state.active);
    }
    workspace.persist();
    render();
  }

  // Sending
  /** The payload sent for an HTTP request, with variables resolved and auth applied. */
  /** What a request sends, with this workspace's variables, uploads, cookies, and certificates. */
  function prepare(request: ApiRequest): RequestPayload {
    const settings = useSettingsStore();
    return payload.preparePayload(request, {
      workspace: { ...workspace.state, settings: workspace.settings() },
      resolve: workspace.resolve,
      upload: (id) => useRequestBodyStore().uploads.get(id),
      cookieJar: useCookiesStore().requestJar(),
      clientCertificate: (url) => settings.requestClientCertificate(url),
    });
  }
  /** Outside Electron, sends with fetch; transports it cannot honour are rejected first. */
  async function browserSend(payload: RequestPayload, request: ApiRequest) {
    if (payload.credentialId) throw new Error('Saved credentials require the desktop application.');
    if (payload.multipart || payload.binary)
      throw new Error('File and multipart uploads require the desktop application.');
    if (payload.clientCertificate)
      throw new Error('Client certificates require the desktop application.');
    if (payload.signing)
      throw new Error(
        `${useAuthenticationStore().effectiveAuth(request).auth} requires the desktop application.`,
      );
    useHTTPSettingsStore().requireDesktop(payloadSettings(payload));
    abortController = new AbortController();
    const timeout = setTimeout(() => abortController?.abort(), payload.timeoutMs);
    const start = performance.now();
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: ['GET', 'HEAD'].includes(payload.method) ? undefined : payload.body || undefined,
        signal: abortController.signal,
        redirect: 'manual',
      });
      if (response.type === 'opaqueredirect')
        throw new Error('Redirect inspection requires the Electron desktop app.');
      const body = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body,
        time: Math.round(performance.now() - start),
        size: new TextEncoder().encode(body).length,
        url: response.url,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  /** Sends a request and records its response, console entries, cookies, captures, and history. */
  async function execute(request: ApiRequest): Promise<RequestResponse> {
    const tools = useToolsStore();
    const tests = useRequestTestsStore();
    let result: RequestResponse;
    const consoleRequest = { ...request, url: workspace.resolve(request.url) };
    const started = Date.now();
    // This send's console lines, also kept with its History entry.
    const lines: HistoryConsoleEntry[] = [];
    const log = (
      level: HistoryConsoleEntry['level'],
      kind: HistoryConsoleEntry['kind'],
      message: string,
    ) => {
      tools.addConsoleEntry(consoleRequest, level, message);
      lines.push({ at: Date.now(), level, message, kind });
    };
    log('info', 'started', 'Request started');
    const scripts = useScriptsStore();
    let pre: StepResult[] = [];
    try {
      await useAuthenticationStore().ensureInlineOAuthToken(request);
      // A pre-request script runs first: its variables resolve in the request, and its changes
      // apply to a copy, so the saved request stays as written.
      const prepared = await scripts.beforeSend(request);
      pre = prepared.results;
      const payload = prepare(prepared.request);
      const moved = pre.length ? scriptHostProblem(consoleRequest.url, payload.url) : undefined;
      if (moved) throw new Error(moved);
      result = window.workbench
        ? await window.workbench.send(payload)
        : await browserSend(payload, request);
    } catch (error) {
      result = { error: errorMessage(error) };
    }
    if (result.error !== undefined)
      log(
        'error',
        'failed',
        `Request failed after ${Date.now() - started} ms: ${tools.consoleSafeError(result.error, consoleRequest)}`,
      );
    else {
      const assertions = tests.runTests(request, result);
      log(
        result.status >= 400 ? 'error' : 'success',
        'completed',
        `${result.status} ${result.statusText} · ${result.time} ms · ${result.size} bytes · ${assertions.filter((test) => test.pass).length}/${assertions.length} assertions passed`,
      );
    }
    tools.addNetworkEntry(consoleRequest, result, started);
    request.response = result;
    useResponseStore().recordSnapshot(request, result);
    const storedCookies = useCookiesStore().storeResponse(result);
    if (storedCookies)
      log(
        'info',
        'cookies',
        `Received ${storedCookies} Set-Cookie header${storedCookies === 1 ? '' : 's'}; cookie jar updated`,
      );
    const captured = tests.applyCaptures(request, result);
    if (captured.length)
      log(
        captured.every((item) => item.error === undefined) ? 'info' : 'error',
        'captures',
        `Captured ${captured.filter((item) => item.error === undefined).length}/${captured.length} variables: ${captured.map((item) => item.variable + (item.error === undefined ? '' : ' (missed)')).join(', ')}`,
      );
    // The post-response script runs last, so it reads the values captures just stored.
    let post: StepResult[] = [];
    try {
      post = await scripts.afterResponse(request, result);
    } catch (error) {
      tools.addConsoleEntry(
        consoleRequest,
        'error',
        `[post-response script] ${errorMessage(error)}`,
      );
    }
    scripts.record(request.id, { response: result, pre, post });
    const settings = workspace.settings();
    const state = workspace.state;
    if (settings.historyEnabled && settings.historyLimit > 0)
      state.history.unshift({
        requestId: request.id,
        method: request.method,
        url: workspace.resolve(request.url),
        status: result.status,
        date: new Date().toISOString(),
        time: result.time ?? result.timings?.totalMs,
        ...(result.error === undefined
          ? { response: historyResponse(result as HttpResponse) }
          : { failure: historyFailure(result) }),
        console: lines,
      });
    state.history = trimHistory(state.history, settings.historyLimit);
    workspace.persist();
    return result;
  }
  /** Sends the active request, or cancels the one in flight. */
  async function send(): Promise<void> {
    const request = workspace.current();
    if (requestProtocol(request) !== 'http') {
      try {
        await useProtocolsStore().connectLiveProtocol();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
      return;
    }
    if (useRunnerStore().run.running) {
      ui.view = 'Runner';
      render();
      return;
    }
    if (ui.busy) {
      if (window.workbench) void window.workbench.cancel(ui.activeRequestId);
      else abortController?.abort();
      return;
    }
    ui.busy = true;
    ui.activeRequestId = request.id;
    render();
    await execute(request);
    ui.busy = false;
    ui.activeRequestId = '';
    render();
  }
  return {
    renameFolder,
    collectionNames,
    folderPathList,
    createRequestIn,
    createCollection,
    createFolder,
    duplicateCollection,
    deleteFolder,
    moveRequest,
    shiftRequest,
    requestQueryURL,
    syncRequestQuery,
    openRequest,
    createRequest,
    duplicateRequest,
    deleteRequest,
    prepare,
    execute,
    send,
  };
});
