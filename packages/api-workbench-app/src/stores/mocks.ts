import { defineStore } from 'pinia';
import { reactive } from 'vue';
import type { MockLogEntry, MockRoute, MockServer } from '@techieutils/api-workbench-common/types';
import {
  freeMockGrpcPort,
  mockOrigin,
  mockPortProblem,
  mockRoutesFromRequests,
  mockRoutesFromSpec,
  newMock,
  newMockRoute,
} from '@techieutils/api-workbench-common/mocks';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import { mockCollectionRequests } from '@techieutils/api-workbench-common/mock-export';
import {
  mockSyncStatus,
  syncMockRoute,
  syncMockWithCollection,
} from '@techieutils/api-workbench-common/mock-sync';
import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import type { MockDocFormat } from '@techieutils/api-workbench-common/mock-docs';
import { confirmAction } from '../confirm';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { useUiStore } from './ui';
import { useDialogsStore } from './dialogs';
import { useRequestsStore } from './requests';
import { makeRequest, useWorkspaceStore } from './workspace';

export type MockTab = 'Routes' | 'Log' | 'API docs';
/** The most requests kept in each mock's log. */
const LOG_LIMIT = 200;

/** Mock servers: routes kept as files, served on localhost by the desktop app while running. */
export const useMocksStore = defineStore('mocks', () => {
  const workspace = useWorkspaceStore();
  const ui = reactive({
    selected: '',
    route: '',
    tab: 'Routes' as MockTab,
    /** The log's search and status filter, the entry whose details show, and their tab. */
    logQuery: '',
    logStatus: 'All' as string,
    logSelected: '',
    logTab: 'Request' as 'Request' | 'Response',
    /** The API docs tab's format: a browsable reference, or a specification to copy or save. */
    docsFormat: 'Reference' as MockDocFormat,
    /** Route editor sections folded away; they stay folded as other routes are selected. */
    collapsed: { match: false, validate: false, respond: false } as Record<
      'match' | 'validate' | 'respond',
      boolean
    >,
  });
  /** Running mocks by id, with the port each listens on. */
  const running = reactive(new Map<string, number>());
  const logs = reactive(new Map<string, MockLogEntry[]>());
  const busy = reactive(new Set<string>());
  // Read on every render: mocks are edited in place, like requests.
  const mocks = (): MockServer[] => workspace.state.mocks ?? [];
  const find = (id: string) => mocks().find((mock) => mock.id === id);
  const current = (): MockServer | undefined => find(ui.selected) ?? mocks()[0];
  const currentRoute = (mock: MockServer | undefined): MockRoute | undefined =>
    mock?.routes.find((route) => route.id === ui.route) ?? mock?.routes[0];
  const url = (mock: MockServer) => mockOrigin(mock);
  const bridge = () => window.workbench?.mocks;

  let listening = false;
  /** Learns which mocks are already running (after a reload) and starts taking their logs. */
  async function initialize(): Promise<void> {
    const api = bridge();
    if (!api || listening) return;
    listening = true;
    api.onLog((entry) => {
      const list = logs.get(entry.mockId) ?? [];
      list.unshift(entry);
      if (list.length > LOG_LIMIT) list.length = LOG_LIMIT;
      logs.set(entry.mockId, list);
    });
    applyStatus(await api.status());
  }
  function applyStatus(status: { running: { id: string; port: number }[] }): void {
    running.clear();
    for (const item of status.running) running.set(item.id, item.port);
  }

  function freeName(base: string): string {
    const taken = new Set(mocks().map((mock) => mock.name.toLowerCase()));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
  function add(mock: MockServer): MockServer {
    (workspace.state.mocks ??= []).push(mock);
    ui.selected = mock.id;
    ui.route = mock.routes[0]?.id ?? '';
    ui.tab = 'Routes';
    workspace.persist();
    render();
    return mock;
  }
  function create(): MockServer {
    return add(newMock(freeName('New mock'), mocks()));
  }
  function createFromCollection(collection: string): MockServer | undefined {
    const requests = workspace.state.requests.filter((request) =>
      isWithin(request.folder, collection),
    );
    const routes = mockRoutesFromRequests(requests);
    if (!routes.length) {
      toast(`${collection} has no requests to mock.`, 'warning');
      return undefined;
    }
    // gRPC routes are served from the first schema a gRPC request in the collection uses.
    const proto = requests.find(
      (request) => request.protocol === 'grpc' && request.grpc?.proto.trim(),
    )?.grpc?.proto;
    const base = newMock(freeName(`${collection} mock`), mocks(), routes);
    const mock = add({
      ...base,
      ...(proto ? { grpc: { proto, port: freeMockGrpcPort(mocks(), base.port) } } : {}),
      source: { kind: 'collection', name: collection },
    });
    toast(
      `Created ${mock.name} with ${routes.length} route${routes.length === 1 ? '' : 's'}`,
      'success',
    );
    return mock;
  }
  /**
   * Starts a mock for a collection and shows it: the one made from it before, if any, otherwise a
   * new one from its requests' saved responses.
   */
  async function startFromCollection(collection: string): Promise<void> {
    const existing = mocks().find(
      (mock) => mock.source?.kind === 'collection' && mock.source.name === collection,
    );
    const mock = existing ?? createFromCollection(collection);
    if (!mock) return;
    if (existing) select(existing.id);
    useUiStore().view = 'Mocks';
    render();
    // Started for the person, so it may move to a free port, as a new one would.
    if (!running.has(mock.id)) await start(mock.id, false, true);
  }
  /** A mock answering every operation in a specification, started at once. */
  async function createFromSpec(name: string, document: Record<string, unknown>): Promise<void> {
    let routes: MockRoute[];
    try {
      routes = mockRoutesFromSpec(document);
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    if (!routes.length) {
      toast(`${name} has no operations to mock.`, 'warning');
      return;
    }
    const mock = add({
      ...newMock(freeName(`${name} mock`), mocks(), routes),
      source: { kind: 'spec', name },
    });
    useUiStore().view = 'Mocks';
    await start(mock.id, false, true);
  }
  function select(id: string): void {
    ui.selected = id;
    ui.route = find(id)?.routes[0]?.id ?? '';
    render();
  }
  function selectRoute(id: string): void {
    ui.route = id;
    render();
  }
  /** Saves an edit; a running mock takes it at once, a moment after typing pauses. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  function changed(mock: MockServer, immediate = false): void {
    workspace.persist();
    render();
    restartIfRunning(mock, immediate);
  }
  // A mock changed with its collection (a request added or changed there) serves the change.
  workspace.onMocksSynced((mocks) => {
    for (const mock of mocks) restartIfRunning(mock);
    render();
  });
  /** A running mock picks up a change: after a pause in editing, or at once. */
  function restartIfRunning(mock: MockServer, immediate = false): void {
    if (!running.has(mock.id)) return;
    clearTimeout(pending.get(mock.id));
    const apply = () => {
      pending.delete(mock.id);
      if (running.has(mock.id) && find(mock.id) && !mockPortProblem(mock.port))
        void start(mock.id, true);
    };
    if (immediate) apply();
    else pending.set(mock.id, setTimeout(apply, 300));
  }
  /** Saves an edit made to a mock in place, such as its route headers in the table. */
  function touch(id: string): void {
    const mock = find(id);
    if (mock) changed(mock);
  }
  function rename(id: string, name: string): void {
    const mock = find(id);
    const next = name.trim().slice(0, 80);
    if (!mock || !next || next === mock.name) return;
    mock.name = next;
    changed(mock);
  }
  function setPort(id: string, port: number): void {
    const mock = find(id);
    if (!mock || mock.port === port) return;
    mock.port = port;
    workspace.persist();
    render();
  }
  function setCors(id: string, cors: boolean): void {
    const mock = find(id);
    if (!mock) return;
    mock.cors = cors;
    changed(mock, true);
  }
  function duplicate(id: string): void {
    const mock = find(id);
    if (!mock) return;
    const copy = structuredClone(mock);
    add({
      ...copy,
      id: crypto.randomUUID(),
      name: freeName(`${mock.name} copy`),
      port: newMock('', mocks()).port,
      routes: copy.routes.map((route) => ({ ...route, id: crypto.randomUUID() })),
    });
    toast(`Duplicated ${mock.name}`, 'success');
  }
  async function remove(id: string): Promise<void> {
    const mock = find(id);
    if (!mock) return;
    const confirmed = await confirmAction({
      title: `Delete the “${mock.name}” mock server?`,
      message: `Its ${mock.routes.length} route${mock.routes.length === 1 ? '' : 's'} and file are removed from the workspace${running.has(id) ? ', and it stops' : ''}.`,
      confirmLabel: 'Delete mock server',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (running.has(id)) await stop(id);
    workspace.state.mocks = mocks().filter((item) => item.id !== id);
    logs.delete(id);
    if (ui.selected === id) select(mocks()[0]?.id ?? '');
    workspace.persist();
    render();
    toast(`Deleted ${mock.name}`, 'success');
  }

  /**
   * Starts a mock, or applies its changes while it runs. A mock just made for you (`movable`)
   * moves to the next free port when another program holds its own.
   */
  async function start(id: string, quiet = false, movable = false): Promise<void> {
    const mock = find(id);
    const api = bridge();
    if (!mock) return;
    if (!api) {
      toast('Mock servers run in the desktop app.', 'warning');
      return;
    }
    const problem = mockPortProblem(mock.port);
    if (problem) {
      toast(problem, 'warning');
      return;
    }
    const wasRunning = running.has(id);
    busy.add(id);
    try {
      for (let attempt = 0; ; attempt++)
        try {
          applyStatus(await api.start(structuredClone(mock)));
          break;
        } catch (error) {
          if (!movable || attempt >= 20 || !/already in use/.test(errorMessage(error))) throw error;
          const taken = new Set(mocks().map((item) => item.port));
          do mock.port++;
          while (taken.has(mock.port));
          workspace.persist();
        }
      if (!quiet) toast(`${mock.name} is running at ${url(mock)}`, 'success');
    } catch (error) {
      toast(
        errorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
        'error',
      );
      if (wasRunning) applyStatus(await api.status());
    } finally {
      busy.delete(id);
      render();
    }
  }
  async function stop(id: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    busy.add(id);
    try {
      applyStatus(await api.stop(id));
    } finally {
      busy.delete(id);
      render();
    }
  }
  /** Applies a new port: a running mock moves to it. */
  async function commitPort(id: string): Promise<void> {
    const mock = find(id);
    if (mock && running.has(id) && running.get(id) !== mock.port) await start(id, true);
  }

  // Routes
  /**
   * Keeps a mock made from a collection in step with it: the route's request there is added, or
   * changed as the route is (`before` is the route as it was).
   */
  function syncRoute(mock: MockServer, route: MockRoute, before?: MockRoute): void {
    syncMockRoute(
      workspace.state.requests,
      mock,
      route,
      ({ name, method, url, folder }) => makeRequest(name, method, url, folder),
      before,
    );
  }
  /** How far a mock made from a collection is from it, or nothing for another mock. */
  function syncStatus(mock: MockServer) {
    return mockSyncStatus(workspace.state.requests, mock);
  }
  /** Sync now: every request a route, every route a request, between a mock and its collection. */
  function syncWithCollection(id: string): void {
    const mock = find(id);
    if (!mock) return;
    const done = syncMockWithCollection(
      workspace.state.requests,
      mock,
      ({ name, method, url, folder }) => makeRequest(name, method, url, folder),
    );
    const parts = [
      done.routesAdded ? `${done.routesAdded} route${done.routesAdded === 1 ? '' : 's'} added` : '',
      done.requestsAdded
        ? `${done.requestsAdded} request${done.requestsAdded === 1 ? '' : 's'} added to ${mock.source?.name}`
        : '',
    ].filter(Boolean);
    toast(parts.length ? `${parts.join(', ')}.` : 'Already in step.', 'success');
    changed(mock, true);
  }
  function addRoute(id: string): MockRoute | undefined {
    const mock = find(id);
    if (!mock) return undefined;
    const route = newMockRoute({ path: '/new-route' });
    mock.routes.push(route);
    syncRoute(mock, route);
    ui.route = route.id;
    changed(mock, true);
    return route;
  }
  function updateRoute(id: string, routeId: string, patch: Partial<MockRoute>): void {
    const mock = find(id);
    const route = mock?.routes.find((item) => item.id === routeId);
    if (!mock || !route) return;
    const before = structuredClone(route);
    Object.assign(route, patch);
    if (['method', 'path', 'name', 'kind'].some((key) => key in patch))
      syncRoute(mock, route, before);
    changed(mock);
  }
  function duplicateRoute(id: string, routeId: string): void {
    const mock = find(id);
    const index = mock?.routes.findIndex((item) => item.id === routeId) ?? -1;
    if (!mock || index < 0) return;
    const copy = { ...structuredClone(mock.routes[index]), id: crypto.randomUUID() };
    delete copy.requestId;
    mock.routes.splice(index + 1, 0, copy);
    syncRoute(mock, copy);
    ui.route = copy.id;
    changed(mock, true);
  }
  function moveRoute(id: string, routeId: string, step: -1 | 1): void {
    const mock = find(id);
    const index = mock?.routes.findIndex((item) => item.id === routeId) ?? -1;
    const target = index + step;
    if (!mock || index < 0 || target < 0 || target >= mock.routes.length) return;
    const [route] = mock.routes.splice(index, 1);
    mock.routes.splice(target, 0, route);
    changed(mock, true);
  }
  function removeRoute(id: string, routeId: string): void {
    const mock = find(id);
    const index = mock?.routes.findIndex((item) => item.id === routeId) ?? -1;
    if (!mock || index < 0) return;
    mock.routes.splice(index, 1);
    if (ui.route === routeId)
      ui.route = mock.routes[Math.min(index, mock.routes.length - 1)]?.id ?? '';
    changed(mock, true);
  }
  /** A request for each of the mock's routes, in `collection`, as full workspace requests. */
  function collectionRequests(mock: MockServer, collection: string): ApiRequest[] {
    return mockCollectionRequests(mock, collection).map((item) => {
      const request = Object.assign(
        makeRequest(item.name, item.method, item.url, item.folder),
        item,
      );
      // Each request checks that the mock still answers as it did when exported.
      const status = item.response && 'status' in item.response ? item.response.status : undefined;
      request.tests = status ? `status ${status}` : '';
      return request;
    });
  }
  /** Adds the mock's routes to the workspace as a new collection, and opens its first request. */
  function exportToCollection(id: string): void {
    const mock = find(id);
    if (!mock) return;
    if (!mock.routes.length) {
      toast(`${mock.name} has no routes to export.`, 'warning');
      return;
    }
    const taken = new Set(workspace.state.requests.map((request) => collectionOf(request.folder)));
    let collection = mock.name;
    for (let n = 2; taken.has(collection); n++) collection = `${mock.name} ${n}`;
    const requests = collectionRequests(mock, collection);
    workspace.state.requests.push(...requests);
    // Starting a mock from this collection later finds this one again.
    mock.source ??= { kind: 'collection', name: collection };
    workspace.persist();
    useRequestsStore().openRequest(requests[0].id);
    toast(
      `Created the ${collection} collection with ${requests.length} request${requests.length === 1 ? '' : 's'}`,
      'success',
    );
  }
  /** Opens the export dialog for the mock's routes, as a collection in any export format. */
  function exportFile(id: string): void {
    const mock = find(id);
    if (!mock) return;
    if (!mock.routes.length) {
      toast(`${mock.name} has no routes to export.`, 'warning');
      return;
    }
    const snapshot = workspace.backupWorkspace();
    snapshot.requests = collectionRequests(mock, mock.name);
    snapshot.settings = { ...workspace.settings(), workspaceName: mock.name };
    snapshot.collectionHttpSettings = {};
    snapshot.collectionAuth = {};
    delete snapshot.collectionScripts;
    delete snapshot.workspaceScripts;
    delete snapshot.scriptLibrary;
    delete snapshot.scriptSnippets;
    delete snapshot.collectionTags;
    useDialogsStore().openTransfer('export', { name: mock.name, snapshot });
  }
  function clearLog(id: string): void {
    logs.delete(id);
    render();
  }
  return {
    syncStatus,
    syncWithCollection,
    ui,
    running,
    logs,
    busy,
    mocks,
    current,
    currentRoute,
    url,
    initialize,
    create,
    createFromCollection,
    createFromSpec,
    startFromCollection,
    select,
    selectRoute,
    touch,
    rename,
    setPort,
    commitPort,
    setCors,
    duplicate,
    remove,
    start,
    stop,
    addRoute,
    updateRoute,
    duplicateRoute,
    moveRoute,
    removeRoute,
    clearLog,
    exportToCollection,
    exportFile,
  };
});
